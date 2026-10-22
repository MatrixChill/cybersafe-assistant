// cybersafe-fallback-canary
// EICAR-only test corpus - NOT production malware coverage.
// The single rule below detects only the EICAR test string, so a scan using it
// proves the pipeline works and nothing more. Reported as degraded, not active,
// so the product does not imply rule-based protection it does not have.
// CyberSafe_Canary_EICAR in packages/core/src/yara.ts is the canonical form.

rule eicar
{
	meta:
		description = "Rule to detect Eicar pattern"
		author = "Marc Rivero | @seifreed"
		hash1 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"

	strings:
		$s1 = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" fullword ascii

	condition:
		all of them
}