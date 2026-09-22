# Security policy

kosmo-tui is a read-only viewer. It MUST NOT install probes, start capture, run migrations
or write to a trace source. The only writes are review artifacts in the project root (or
`--review-dir`), and `-r` disables them together with local eval.

- Endpoint URLs with userinfo or token query parameters are rejected; credentials are only
  sent to the allowed origin and never forwarded across a cross-origin redirect.
- Tokens are read from the configured `auth.projectTokenFile`; they never appear in argv,
  URLs or logs.
- `eval` runs explicitly trusted local code in a child process with a deadline and heap
  cap. It is not a sandbox.

Report vulnerabilities privately to the maintainers instead of opening a public issue.
