This lens is security (the security skill, if available).
- Follow untrusted input (requests, MQTT messages, files, PR
  content in CI) from where it enters to where it is used:
  injection, path traversal, unbounded sizes, unsafe parsing.
- Check authn/authz on every new or changed endpoint, query
  and handler, including tenant and workspace scoping.
- Look for secrets or tokens in code, logs and errors,
  weakened crypto or TLS, and workflow or token permissions
  wider than the job needs.
