
// cybersafe-fallback-canary
// written when the real rules corpus could not be loaded
rule CyberSafe_Canary_EICAR
{
  meta:
    description = "CyberSafe test canary - not production detection"
    author = "CyberSafe"
    reference = "https://www.eicar.org/download-anti-malware-test-file/"

  strings:
    $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" ascii

  condition:
    $eicar
}
