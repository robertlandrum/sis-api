# Outstanding API changes

1. Conversion from CJS to ESM
2. Disable Hooks and Endpoints and Scripts from being enabled by default
3. Provide an endpoint for the SIS-UI to consume that adjusts the UI based on the API configuration
	a. Specifically this should expose the settings for hooks, endpoints, and authenticated reads
	b. Endpoint might need to inform the UI about SAML configuration for redirection to the IdP
4. Add kafka stream configuration to schemas
	a. schema streaming should be optional
	b. schema streaming should only accept a single kafka topic
	c. kafka server and other connection configuration should come from the API server configuration
5. Add kafka streaming to entity inserts, updates, and deletes
6. Convert permanent non-expiring token to JWT with configurable expiration (default is 1 year)
	a. Ensure creating permanent JWTs doesn't revoke any session JWTs
7. Add SAML endpoint for authentication
8. Investigate browser fingerprinting as a mechanism to prevent session JWT replays



