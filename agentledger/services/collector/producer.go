package main

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// ErrBackpressure is returned by TryProduce when the producer is at capacity.
// The ingest handler maps it to HTTP 429 — the collector never blocks.
var ErrBackpressure = errors.New("producer at capacity")

// ProducerStats is a point-in-time snapshot of producer counters.
type ProducerStats struct {
	Produced int64
	Failed   int64
	Inflight int64
}

// Producer delivers raw event payloads to the event bus. Implementations must
// be non-blocking: TryProduce either accepts the record for async delivery or
// returns ErrBackpressure immediately.
type Producer interface {
	// TryProduce enqueues value (keyed by key for partitioning) for async
	// delivery. It must not block; returns ErrBackpressure when at capacity.
	TryProduce(key, value []byte) error
	Stats() ProducerStats
	Ready() bool
	Close()
}

// KafkaProducer is the franz-go backed Producer targeting Redpanda/Kafka.
type KafkaProducer struct {
	cl          *kgo.Client
	topic       string
	maxInflight int64

	inflight atomic.Int64
	produced atomic.Int64
	failed   atomic.Int64
}

// NewKafkaProducer constructs a client against the given brokers/topic. The
// client dials lazily; readiness is reported via Ready().
func NewKafkaProducer(brokers []string, topic string, maxInflight int) (*KafkaProducer, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.AllowAutoTopicCreation(),
		kgo.ProducerLinger(5*time.Millisecond),
		kgo.RecordRetries(5),
		kgo.RequiredAcks(kgo.AllISRAcks()),
	)
	if err != nil {
		return nil, err
	}
	return &KafkaProducer{cl: cl, topic: topic, maxInflight: int64(maxInflight)}, nil
}

// TryProduce enqueues a record for asynchronous production, returning
// ErrBackpressure when the inflight gate is already full.
func (p *KafkaProducer) TryProduce(key, value []byte) error {
	if p.inflight.Add(1) > p.maxInflight {
		p.inflight.Add(-1)
		return ErrBackpressure
	}
	rec := &kgo.Record{Topic: p.topic, Key: key, Value: value}
	// franz-go buffers internally (well above maxInflight) so Produce returns
	// promptly; the callback settles the inflight gate and counters.
	p.cl.Produce(context.Background(), rec, func(_ *kgo.Record, err error) {
		p.inflight.Add(-1)
		if err != nil {
			p.failed.Add(1)
			slog.Warn("produce failed", "err", err, "topic", p.topic)
			return
		}
		p.produced.Add(1)
	})
	return nil
}

// Stats returns a snapshot of produced, failed, and inflight record counts.
func (p *KafkaProducer) Stats() ProducerStats {
	return ProducerStats{
		Produced: p.produced.Load(),
		Failed:   p.failed.Load(),
		Inflight: p.inflight.Load(),
	}
}

// Ready pings the brokers to confirm connectivity for readiness checks.
func (p *KafkaProducer) Ready() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return p.cl.Ping(ctx) == nil
}

// Close flushes any buffered records and shuts down the underlying client.
func (p *KafkaProducer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = p.cl.Flush(ctx)
	p.cl.Close()
}
