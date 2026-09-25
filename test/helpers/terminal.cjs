/* global process */
// Exercise the real confirmation code with controllable pipe input. This does
// not emulate terminal line editing; it only passes the CLI's TTY prerequisite.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
