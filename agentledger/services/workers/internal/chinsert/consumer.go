package chinsert

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// Consumer reads events.raw and drives them through the Pipeline. Offsets are
// committed only after a batch is durably inserted (or its poison rows are
// dead-lettered), so a crash mid-batch re-delivers rather than loses events.
type Consumer struct {
	cl       *kgo.Client
	pipeline *Pipeline
	backoff  time.Duration
}

// NewConsumer creates a Kafka consumer for the given topic and group that commits
// offsets explicitly, only after a batch is durably inserted.
func NewConsumer(brokers []string, topic, group string, pipeline *Pipeline, backoff time.Duration) (*Consumer, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(), // we commit explicitly after a successful insert
		kgo.FetchMaxWait(500*time.Millisecond),
	)
	if err != nil {
		return nil, err
	}
	return &Consumer{cl: cl, pipeline: pipeline, backoff: backoff}, nil
}

// Run polls until ctx is cancelled. Insert failures (ClickHouse down) cause the
// batch to be retried in place — the consumer stalls rather than dropping or
// committing, which is safe because the broker retains the records.
func (c *Consumer) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		fetches := c.cl.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				if errors.Is(e.Err, context.Canceled) {
					return
				}
				slog.Error("fetch error", "topic", e.Topic, "partition", e.Partition, "err", e.Err)
			}
			continue
		}

		recs := make([]*kgo.Record, 0, fetches.NumRecords())
		msgs := make([][]byte, 0, fetches.NumRecords())
		fetches.EachRecord(func(r *kgo.Record) {
			recs = append(recs, r)
			msgs = append(msgs, r.Value)
		})
		if len(msgs) == 0 {
			continue
		}

		for {
			if err := c.pipeline.Process(ctx, msgs); err == nil {
				break
			} else if ctx.Err() != nil {
				return
			} else {
				slog.Error("batch insert failed; retrying", "err", err, "n", len(msgs))
				select {
				case <-ctx.Done():
					return
				case <-time.After(c.backoff):
				}
			}
		}

		if err := c.cl.CommitRecords(ctx, recs...); err != nil {
			slog.Error("offset commit failed", "err", err)
		}
	}
}

// Ping reports broker reachability for readiness checks.
func (c *Consumer) Ping(ctx context.Context) error { return c.cl.Ping(ctx) }

// Close shuts down the underlying Kafka client.
func (c *Consumer) Close() { c.cl.Close() }

// KafkaDLQ produces poison messages to the dead-letter topic, tagging each with
// the failure reason so operators can triage from the message header alone.
type KafkaDLQ struct {
	cl    *kgo.Client
	topic string
}

// NewKafkaDLQ creates a producer for the dead-letter topic, enabling auto topic
// creation so poison messages are never lost.
func NewKafkaDLQ(brokers []string, topic string) (*KafkaDLQ, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.AllowAutoTopicCreation(),
	)
	if err != nil {
		return nil, err
	}
	return &KafkaDLQ{cl: cl, topic: topic}, nil
}

// DeadLetter synchronously produces a poison message to the dead-letter topic,
// tagging it with the failure reason in a header.
func (d *KafkaDLQ) DeadLetter(ctx context.Context, raw []byte, reason string) error {
	rec := &kgo.Record{
		Topic:   d.topic,
		Value:   raw,
		Headers: []kgo.RecordHeader{{Key: "dlq-reason", Value: []byte(reason)}},
	}
	return d.cl.ProduceSync(ctx, rec).FirstErr()
}

// Close shuts down the underlying Kafka client.
func (d *KafkaDLQ) Close() { d.cl.Close() }
