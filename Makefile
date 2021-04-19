SHELL = /bin/sh

.PHONY = all bootstrap

all: bootstrap

bootstrap:
	./bootstrap.sh -f
