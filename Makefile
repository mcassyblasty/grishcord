.PHONY: test install-sanity

test:
	cd backend && npm test


install-sanity:
	./tests/install_sanity_check.sh
	./tests/install_flow_regression_check.sh
