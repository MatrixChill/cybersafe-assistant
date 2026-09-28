
rule Basic_Suspicious_Check
{
  strings:
    $s1 = "powershell.exe" nocase
    $s2 = "cmd.exe /c" nocase
  condition:
    any of them
}
