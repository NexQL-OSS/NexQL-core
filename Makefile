.PHONY: all clean install build package package-nightly publish publish-nightly publish-ovsx publish-vsx git-tag test test-unit test-integration test-renderer test-all coverage docker-up docker-down

# Variables
NODE_BIN := node
NPM_BIN := npm
VSCE_CMD := npx -y @vscode/vsce@2.24.0
OVSX_CMD := npx -y ovsx
OPENVSX_NIGHTLY_NAME ?= postgres-explorer-nightly
# Evaluate once per make invocation to keep package/publish nightly version consistent.
NIGHTLY_RUN_NUMBER := $(shell date +%s)

# Get version and name from package.json using node
EXTENSION_NAME := $(shell $(NODE_BIN) -p "require('./package.json').name")
EXTENSION_VERSION := $(shell $(NODE_BIN) -p "require('./package.json').version")
VSIX_FILE := $(EXTENSION_NAME)-$(EXTENSION_VERSION).vsix

# Default target
all: clean install build package

# Clean build artifacts
clean:
	rm -rf out dist *.vsix node_modules

# Install dependencies
install:
	$(NPM_BIN) install

# Build the extension
build:
	$(NPM_BIN) run vscode:prepublish

# Package the extension
package: build
	@echo "Replacing README.md with MARKETPLACE.md for packaging..."
	@if [ -f README.md ]; then cp README.md README.md.bak; fi
	@cp MARKETPLACE.md README.md
	@trap 'if [ -f README.md.bak ]; then mv README.md.bak README.md; fi' EXIT INT TERM; \
	$(VSCE_CMD) package; \
	EXIT_CODE=$$?; \
	if [ -f README.md.bak ]; then mv README.md.bak README.md; fi; \
	echo "Restored original README.md"; \
	exit $$EXIT_CODE

# Package nightly VSIX artifacts for Marketplace (pre-release) and Open VSX companion
package-nightly: build
	@echo "Computing nightly version..."
	@NIGHTLY_VERSION=$$($(NODE_BIN) -e "const [maj,min]=require('./package.json').version.split('.').map(Number); const nightlyMinor=min%2===0?min+1:min; const run='$(NIGHTLY_RUN_NUMBER)'; process.stdout.write(maj + '.' + nightlyMinor + '.' + run)"); \
	echo "Using nightly version: $$NIGHTLY_VERSION"; \
	NIGHTLY_VERSION=$$NIGHTLY_VERSION OPENVSX_NIGHTLY_NAME=$(OPENVSX_NIGHTLY_NAME) $(NODE_BIN) ./scripts/prepare-nightly-manifests.js
	@echo "Packaging VS Code Marketplace nightly (pre-release)..."
	@cp package.json package.json.bak
	@cp .nightly/package.marketplace.json package.json
	@$(VSCE_CMD) package --pre-release
	@mv package.json.bak package.json
	@echo "Packaging Open VSX nightly companion..."
	@cp package.json package.json.bak
	@cp .nightly/package.openvsx.json package.json
	@$(VSCE_CMD) package
	@mv package.json.bak package.json
	@echo "Nightly packages created:"
	@ls -1 *.vsix

# Publish the extension to VS Code Marketplace and Open VSX Registry
publish: package
	@echo "Publishing $(VSIX_FILE) to VS Code Marketplace..."
	test -f ./pat || (echo "Error: pat file not found. Please create a file named 'pat' containing your Personal Access Token." && exit 1)
	$(VSCE_CMD) publish --packagePath $(VSIX_FILE) -p $(shell cat ./pat)
	@echo "Successfully published to VS Code Marketplace."

	@echo "Publishing $(VSIX_FILE) to Open VSX Registry..."
	test -f ./pat-open-vsx || (echo "Error: pat-open-vsx file not found. Please create a file named 'pat-open-vsx' containing your Open VSX Access Token." && exit 1)
	$(OVSX_CMD) publish $(VSIX_FILE) -p $(shell cat ./pat-open-vsx)
	@echo "Successfully published to Open VSX Registry."

# Publish nightly artifacts to both VS Code Marketplace and Open VSX
publish-nightly: package-nightly
	@echo "Publishing nightly pre-release to VS Code Marketplace..."
	test -f ./pat || (echo "Error: pat file not found. Please create a file named 'pat' containing your Personal Access Token." && exit 1)
	@NIGHTLY_VERSION=$$($(NODE_BIN) -e "const [maj,min]=require('./package.json').version.split('.').map(Number); const nightlyMinor=min%2===0?min+1:min; const run='$(NIGHTLY_RUN_NUMBER)'; process.stdout.write(maj + '.' + nightlyMinor + '.' + run)"); \
	MARKET_VSIX="$(EXTENSION_NAME)-$$NIGHTLY_VERSION.vsix"; \
	$(VSCE_CMD) publish --pre-release --packagePath $$MARKET_VSIX -p $$(cat ./pat)
	@echo "Publishing nightly companion to Open VSX..."
	test -f ./pat-open-vsx || (echo "Error: pat-open-vsx file not found. Please create a file named 'pat-open-vsx' containing your Open VSX Access Token." && exit 1)
	@NIGHTLY_VERSION=$$($(NODE_BIN) -e "const [maj,min]=require('./package.json').version.split('.').map(Number); const nightlyMinor=min%2===0?min+1:min; const run='$(NIGHTLY_RUN_NUMBER)'; process.stdout.write(maj + '.' + nightlyMinor + '.' + run)"); \
	OPENVSX_VSIX="$(OPENVSX_NIGHTLY_NAME)-$$NIGHTLY_VERSION.vsix"; \
	$(OVSX_CMD) publish $$OPENVSX_VSIX -p $$(cat ./pat-open-vsx)
	@echo "Successfully published nightly builds to both registries."

# Publish the extension to VS Code Marketplace only
publish-vsx: package
	@echo "Publishing $(VSIX_FILE) to VS Code Marketplace..."
	test -f ./pat || (echo "Error: pat file not found" && exit 1)
	$(VSCE_CMD) publish --packagePath $(VSIX_FILE) -p $(shell cat ./pat)

# Publish the extension to Open VSX Registry only
publish-ovsx: package
	@echo "Publishing $(VSIX_FILE) to Open VSX Registry..."
	test -f ./pat-open-vsx || (echo "Error: pat-open-vsx file not found" && exit 1)
	$(OVSX_CMD) publish $(VSIX_FILE) -p $(shell cat ./pat-open-vsx)

# Watch mode for development
watch:
	$(NPM_BIN) run watch

# Testing targets
test:
	$(NPM_BIN) run test

test-unit:
	$(NPM_BIN) run test:unit

test-integration:
	$(NPM_BIN) run test:integration

test-renderer:
	$(NPM_BIN) run test:renderer

test-all:
	$(NPM_BIN) run test:all

coverage:
	$(NPM_BIN) run coverage

coverage-report:
	$(NPM_BIN) run coverage:report
	@echo "Coverage report generated in ./coverage/index.html"

# Docker testing targets
docker-up:
	docker-compose -f docker-compose.test.yml up -d
	@echo "PostgreSQL test containers started"
	@echo "Versions available on ports: 12(5412), 14(5414), 15(5415), 16(5416), 17(5417)"

docker-down:
	docker-compose -f docker-compose.test.yml down

docker-logs:
	docker-compose -f docker-compose.test.yml logs -f

docker-clean:
	docker-compose -f docker-compose.test.yml down -v
	@echo "Test containers and volumes removed"

# update npm dependencies
npm-update:
	$(NPM_BIN) update
	@echo "npm dependencies updated"

# Full test suite
test-full: docker-up test-all coverage docker-down
	@echo "Full test suite completed"

# Git tag and version bump (interactive)
git-tag:
	@echo "Current version: $(EXTENSION_VERSION)"
	@read -p "Enter the new version number (e.g., 1.0.1): " VERSION; \
	VERSION=$${VERSION#v}; \
	if [ -z "$$VERSION" ]; then echo "Version cannot be empty"; exit 1; fi; \
	echo "Updating package.json version to $$VERSION..."; \
	$(NODE_BIN) -e "let pkg=require('./package.json'); pkg.version='$$VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));"; \
	echo "package.json updated."; \
	git add package.json; \
	git commit -m "Bump version to $$VERSION"; \
	git tag -a "v$$VERSION" -m "Release v$$VERSION"; \
	git push origin main; \
	git push origin "v$$VERSION"; \
	echo "Git tag v$$VERSION created and pushed."

# Help target
help:
	@echo "Available targets:"
	@echo "  all             : Clean, install, build, and package"
	@echo "  clean           : Remove build artifacts"
	@echo "  install         : Install dependencies"
	@echo "  build           : Build the extension"
	@echo "  package         : Create VSIX package"
	@echo "  package-nightly : Create nightly VSIX packages (Marketplace pre-release + Open VSX companion)"
	@echo "  publish         : Publish to BOTH VS Code Marketplace and Open VSX"
	@echo "  publish-nightly : Publish nightly builds to BOTH VS Code Marketplace and Open VSX"
	@echo "  publish-vsx     : Publish to VS Code Marketplace only"
	@echo "  publish-ovsx    : Publish to Open VSX Registry only"
	@echo "  git-tag         : Interactive version bump, commit, tag, and push"
	@echo ""
	@echo "Testing targets:"
	@echo "  test            : Run unit tests"
	@echo "  test-unit       : Run unit tests only"
	@echo "  test-integration: Run integration tests"
	@echo "  test-renderer   : Run renderer component tests"
	@echo "  test-all        : Run all tests"
	@echo "  coverage        : Generate coverage report"
	@echo "  coverage-report : Generate HTML coverage report"
	@echo ""
	@echo "Docker testing targets:"
	@echo "  docker-up       : Start PostgreSQL test containers (12-17)"
	@echo "  docker-down     : Stop and remove test containers"
	@echo "  docker-logs     : View container logs"
	@echo "  docker-clean    : Remove containers and volumes"
	@echo "  test-full       : Run full test suite with Docker (docker-up → test-all → docker-down)"