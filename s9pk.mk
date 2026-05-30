# Shared StartOS package build rules.

PACKAGE_ID := $(shell awk -F"'" '/id:/ {print $$2}' startos/manifest/index.ts)
INGREDIENTS := $(shell start-cli s9pk list-ingredients 2>/dev/null)
ARCHES ?= x86 arm
TARGETS ?= arches

ifdef VARIANT
BASE_NAME := $(PACKAGE_ID)_$(VARIANT)
else
BASE_NAME := $(PACKAGE_ID)
endif

.PHONY: all arches aarch64 x86_64 arm arm64 x86 arch/% clean install check-deps check-init ingredients
.DELETE_ON_ERROR:
.SECONDARY:

define SUMMARY
	@manifest=$$(start-cli s9pk inspect $(1) manifest); \
	size=$$(du -h $(1) | awk '{print $$1}'); \
	title=$$(printf '%s' "$$manifest" | jq -r .title); \
	version=$$(printf '%s' "$$manifest" | jq -r .version); \
	arches=$$(printf '%s' "$$manifest" | jq -r '[.images[].arch // []] | flatten | unique | join(", ")'); \
	sdkv=$$(printf '%s' "$$manifest" | jq -r .sdkVersion); \
	gitHash=$$(printf '%s' "$$manifest" | jq -r .gitHash); \
	printf "\nBuild complete\n\n"; \
	printf "%s   v%s\n" "$$title" "$$version"; \
	printf "Filename:   %s\n" "$(1)"; \
	printf "Size:       %s\n" "$$size"; \
	printf "Arch:       %s\n" "$$arches"; \
	printf "SDK:        %s\n" "$$sdkv"; \
	printf "Git:        %s\n\n" "$$gitHash"
endef

all: $(TARGETS)

arches: $(ARCHES)

universal: $(BASE_NAME).s9pk
	$(call SUMMARY,$<)

arch/%: $(BASE_NAME)_%.s9pk
	$(call SUMMARY,$<)

x86 x86_64: arch/x86_64
arm arm64 aarch64: arch/aarch64

$(BASE_NAME).s9pk: $(INGREDIENTS) .git/HEAD .git/index
	@$(MAKE) --no-print-directory ingredients
	@echo "Packing '$@'..."
	start-cli s9pk pack -o $@

$(BASE_NAME)_%.s9pk: $(INGREDIENTS) .git/HEAD .git/index
	@$(MAKE) --no-print-directory ingredients
	@echo "Packing '$@'..."
	start-cli s9pk pack --arch=$* -o $@

ingredients: $(INGREDIENTS)
	@echo "Re-evaluating ingredients..."

install: | check-deps check-init
	@S9PK=$$(ls -t *.s9pk 2>/dev/null | head -1); \
	if [ -z "$$S9PK" ]; then \
		echo "Error: No .s9pk file found. Run 'make' first."; \
		exit 1; \
	fi; \
	start-cli package install -s "$$S9PK"

check-deps:
	@command -v start-cli >/dev/null || (echo "Error: start-cli not found." && exit 1)
	@command -v pnpm >/dev/null || (echo "Error: pnpm not found." && exit 1)

check-init:
	@if [ ! -f ~/.startos/developer.key.pem ]; then \
		echo "Initializing StartOS developer key..."; \
		start-cli init-key; \
	fi

javascript/index.js: $(shell find startos -type f) package.json pnpm-lock.yaml tsconfig.json node_modules
	pnpm run build:startos

node_modules: pnpm-lock.yaml package.json
	pnpm install --frozen-lockfile

clean:
	@echo "Cleaning package artifacts..."
	@rm -rf $(PACKAGE_ID).s9pk $(PACKAGE_ID)_x86_64.s9pk $(PACKAGE_ID)_aarch64.s9pk javascript
