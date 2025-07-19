SHELL = /bin/sh

.PHONY = all apply

all: apply

apply:
	./.apply -f
