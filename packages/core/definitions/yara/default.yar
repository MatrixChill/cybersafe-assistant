// CyberSafe test canary - written only when the real rules corpus fails to load.
// This is NOT malware detection. See FALLBACK_RULES in src/yara.ts.

// cybersafe-fallback-canary
rule CyberSafe_Canary_EICAR
{
  meta:
    description = "CyberSafe test canary - not production detection"
    author = "CyberSafe"
    reference = "https://www.eicar.org/download-anti-malware-testfile/"

  strings:
    $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" ascii

  condition:
    $eicar
}