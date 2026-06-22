# Pin Terraform itself. Provider requirements are intentionally omitted: this is
# a cloud-agnostic stub (ADR-039), so no provider is wired yet. Add the chosen
# cloud's provider here when implementing main.tf.
terraform {
  required_version = ">= 1.6.0"
}
