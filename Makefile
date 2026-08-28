# The authoritative build lives in agentledger/. The repository root only
# carries meta files (.github/, docs/, README, this Makefile). Every target
# here forwards to agentledger/Makefile so `make <target>` works from the root.
# Run anything not listed with: make -C agentledger <target>
AGENTLEDGER := agentledger

.PHONY: help install dev up down lint test e2e build migrate audit deps smoke openapi

help:
	@echo "The authoritative build lives in $(AGENTLEDGER)/. This root Makefile"
	@echo "forwards to $(AGENTLEDGER)/Makefile so make works from the repo root."
	@echo ""
	@echo "Common targets: install dev up down lint test e2e build migrate audit"
	@echo "Anything else:  make -C $(AGENTLEDGER) <target>"

# Node toolchain install (Go/Python prerequisites: see agentledger/README.md).
install:
	$(MAKE) -C $(AGENTLEDGER) api-install

# Local dev stack (docker compose).
dev up:
	$(MAKE) -C $(AGENTLEDGER) up

# Same-named passthrough targets defined in agentledger/Makefile.
down lint test e2e build migrate audit deps smoke openapi:
	$(MAKE) -C $(AGENTLEDGER) $@
