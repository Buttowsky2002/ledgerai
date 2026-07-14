# MSK Serverless — Kafka-compatible event bus with IAM SASL auth.
# Topics are created post-apply via the kafka CLI (see TODO below).

resource "aws_security_group" "msk" {
  name_prefix = "${var.name}-msk-"
  description = "MSK Serverless — ingress from ECS tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-msk" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_ecs" {
  security_group_id            = aws_security_group.msk.id
  referenced_security_group_id = var.ecs_task_security_group_id
  from_port                    = 9098
  to_port                      = 9098
  ip_protocol                  = "tcp"
  description                  = "Kafka IAM SASL from ECS tasks"
}

resource "aws_vpc_security_group_egress_rule" "msk_out" {
  security_group_id = aws_security_group.msk.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all egress"
}

resource "aws_msk_serverless_cluster" "main" {
  cluster_name = "${var.name}-kafka"

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.msk.id]
  }

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }

  tags = var.tags
}

# TODO: MSK Serverless does not support the aws_msk_topic Terraform resource.
# Create topics manually after apply:
#
#   BOOTSTRAP=$(terraform output -raw kafka_bootstrap_brokers)
#   for TOPIC in events.raw events.dlq; do
#     aws kafka create-topic \
#       --cluster-arn "$(terraform output -raw kafka_cluster_arn)" \
#       --topic-name "$TOPIC" \
#       --partitions 12 \
#       --replication-factor 3 \
#       2>/dev/null || echo "$TOPIC may already exist"
#   done
#
# Or use kafka-topics.sh with IAM auth:
#   kafka-topics.sh --bootstrap-server "$BOOTSTRAP" \
#     --command-config /path/to/client.properties \
#     --create --topic events.raw --partitions 12 --config retention.ms=604800000
