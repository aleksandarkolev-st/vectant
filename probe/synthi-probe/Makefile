# synthi-probe reference build. POSIX-only, no external deps.
#
# Targets:
#   make            -> build/libsynthi_probe.a + build/libsynthi_probe.so
#   make example    -> build/example_counter
#   make clean

CC      ?= cc
AR      ?= ar
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -fPIC
LDFLAGS ?=
INCLUDE := -Iinclude

SRCS    := src/synthi_probe.c
OBJS    := $(patsubst src/%.c,build/%.o,$(SRCS))

.PHONY: all clean example

all: build/libsynthi_probe.a build/libsynthi_probe.so

build:
	mkdir -p build

build/%.o: src/%.c include/synthi_probe.h | build
	$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

build/libsynthi_probe.a: $(OBJS)
	$(AR) rcs $@ $(OBJS)

build/libsynthi_probe.so: $(OBJS)
	$(CC) $(CFLAGS) -shared $^ -o $@

example: build/example_counter

build/example_counter: examples/example_counter.c build/libsynthi_probe.a | build
	$(CC) $(CFLAGS) $(INCLUDE) $< build/libsynthi_probe.a -o $@

clean:
	rm -rf build
