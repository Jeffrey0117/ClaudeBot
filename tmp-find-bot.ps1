Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  Write-Output "$($_.ProcessId) | $($_.CommandLine)"
}
