// Tests deliberately inject a non-production proof authority. Production
// code has no built-in signing secret and must receive one from deployment.
process.env.SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET ||= 'vitest-codesite-proof-authority';
process.env.SYNTHI_CODESITE_PROOF_REQUIRE_TRUSTED_AUTHORITY ||= '0';
