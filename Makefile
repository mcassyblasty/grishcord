.PHONY: test install-sanity

test:
	cd backend && npm test


install-sanity:
	./tests/install_sanity_check.sh
