# 环境诊断实验（PR #5 CI）：只由 verify.yml 的手动触发（envtest 非空）在 GitHub 一次性运行器上调用，运行结束虚拟机即销毁。
# 不是正式回归，也不是修复；实验结果只用于归因。
# 组：baseline 只记录不干预；storsvc 只停存储服务 StorSvc；compattel 只干预兼容性遥测：停掉实际启动 CompatTelRunner.exe 的
# InventorySvc 服务（e00771f 的实验确认：运行器镜像上两个相关计划任务本来就是禁用的，CompatTelRunner 的父进程是
# svchost -k InvSvcGroup -s InventorySvc），同时禁用相关计划任务并结束正在运行的该进程。
# 阶段：before 记录环境 → 干预 → 核对干预是否生效 → 启动后台监视；monitor 每 20 秒记一行（最多 45 分钟）；after 核对结束时状态并汇总监视记录。
param(
    [Parameter(Mandatory)][ValidateSet('baseline', 'storsvc', 'compattel')][string]$Group,
    [Parameter(Mandatory)][ValidateSet('before', 'monitor', 'after')][string]$Phase
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$monitorLog = Join-Path $env:RUNNER_TEMP 'ar-env-monitor.log'
$monitorPid = Join-Path $env:RUNNER_TEMP 'ar-env-monitor.pid'

function Get-StorSvc { Get-CimInstance Win32_Service -Filter "Name='StorSvc'" }
function Get-InvSvc { Get-CimInstance Win32_Service -Filter "Name='InventorySvc'" }
function Get-Tel { @(Get-CimInstance Win32_Process -Filter "Name='CompatTelRunner.exe'") }
# 启动 CompatTelRunner.exe 的计划任务：按任务动作里的可执行文件匹配（它是进程，不是服务）。
function Get-TelTasks { @(Get-ScheduledTask | Where-Object { @($_.Actions | Where-Object { $_.Execute -match 'CompatTelRunner' }).Count -gt 0 }) }
function Cpu-Seconds([int]$id) { if ($id -gt 0) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { return [math]::Round($p.TotalProcessorTime.TotalSeconds, 1) } }; return $null }

function Show-State([string]$tag) {
    $svc = Get-StorSvc
    "[$tag] StorSvc：状态 $($svc.State)，启动类型 $($svc.StartMode)，宿主进程 $($svc.ProcessId)，累计 CPU $(Cpu-Seconds $svc.ProcessId) 秒"
    $inv = Get-InvSvc
    "[$tag] InventorySvc：状态 $($inv.State)，启动类型 $($inv.StartMode)，宿主进程 $($inv.ProcessId)"
    $tel = Get-Tel
    if (-not $tel.Count) { "[$tag] CompatTelRunner：没有在运行" }
    foreach ($p in $tel) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
        $parentText = if ($parent) { "$($parent.Name)#$($p.ParentProcessId)（$($parent.CommandLine)）" } else { "#$($p.ParentProcessId)（已退出）" }
        "[$tag] CompatTelRunner #$($p.ProcessId)：父进程 $parentText；命令行 $($p.CommandLine)；启动于 $($p.CreationDate)；累计 CPU $(Cpu-Seconds $p.ProcessId) 秒"
    }
    foreach ($t in Get-TelTasks) {
        $info = Get-ScheduledTaskInfo -TaskPath $t.TaskPath -TaskName $t.TaskName -ErrorAction SilentlyContinue
        $triggers = (@($t.Triggers) | Where-Object { $_ } | ForEach-Object { ($_.PSObject.TypeNames[0] -split '[/#]')[-1] -replace 'MSFT_Task|Trigger', '' }) -join '、'
        if (-not $triggers) { $triggers = '无' }
        "[$tag] 计划任务 $($t.TaskPath)$($t.TaskName)：状态 $($t.State)，触发 $triggers，上次运行 $($info.LastRunTime)，结果 $($info.LastTaskResult)，动作 $(($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ')"
    }
}

if ($Phase -eq 'before') {
    $os = Get-CimInstance Win32_OperatingSystem
    "环境实验组：$Group；运行器镜像 $env:ImageOS $env:ImageVersion；系统 $($os.Caption) $($os.Version)；逻辑处理器 $([Environment]::ProcessorCount)；内存 $([math]::Round($os.TotalVisibleMemorySize / 1MB, 1)) GB（可用 $([math]::Round($os.FreePhysicalMemory / 1MB, 1)) GB）"
    Show-State '干预前'
    if ($Group -eq 'storsvc') {
        # 只停 StorSvc；它是按需触发启动的服务，临时把启动类型设为禁用，免得运行中被触发重启（随虚拟机销毁）。
        Set-Service -Name StorSvc -StartupType Disabled -ErrorAction Continue
        Stop-Service -Name StorSvc -Force -ErrorAction Continue
    }
    elseif ($Group -eq 'compattel') {
        foreach ($t in Get-TelTasks) {
            Stop-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -ErrorAction Continue
            Disable-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -ErrorAction Continue | Out-Null
        }
        # 实际启动来源是 InventorySvc：同样临时设为禁用再停止，免得运行中被重新拉起（随虚拟机销毁）。
        Set-Service -Name InventorySvc -StartupType Disabled -ErrorAction Continue
        Stop-Service -Name InventorySvc -Force -ErrorAction Continue
        Get-Process -Name CompatTelRunner -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Continue
        Start-Sleep -Seconds 2
    }
    Show-State '干预后'
    # 干预是否生效：storsvc 组要求服务已停止；compattel 组要求相关计划任务都已禁用且没有 CompatTelRunner 在运行。
    $svc = Get-StorSvc
    if ($Group -eq 'storsvc') { if ($svc.State -eq 'Stopped') { '干预生效：StorSvc 已停止' } else { "干预未生效：StorSvc 仍为 $($svc.State)" } }
    if ($Group -eq 'compattel') {
        $enabled = @(Get-TelTasks | Where-Object { $_.State -ne 'Disabled' })
        $inv = Get-InvSvc
        if ($inv.State -ne 'Stopped' -or $enabled.Count -or (Get-Tel).Count) { "干预未生效：InventorySvc $($inv.State)，仍启用的任务 $($enabled.Count) 个，仍在运行的 CompatTelRunner $((Get-Tel).Count) 个" }
        else { '干预生效：InventorySvc 已停止，相关计划任务都已禁用，没有 CompatTelRunner 在运行' }
    }
    # 后台监视（三组都开，保持条件一致）：每 20 秒记一行，最多 45 分钟。
    $p = Start-Process pwsh -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-File', $PSCommandPath, '-Group', $Group, '-Phase', 'monitor')
    Set-Content -Path $monitorPid -Value $p.Id -Encoding utf8
    "后台监视已启动：进程 $($p.Id)，记录在运行器临时目录 ar-env-monitor.log"
}
elseif ($Phase -eq 'monitor') {
    $start = Get-Date
    while (((Get-Date) - $start).TotalMinutes -lt 45) {
        $svc = Get-StorSvc
        $tel = Get-Tel
        $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
        $telCpu = ($tel | ForEach-Object { Cpu-Seconds $_.ProcessId } | Measure-Object -Sum).Sum
        $line = "$((Get-Date).ToString('HH:mm:ss')) 总 CPU $total% | StorSvc $($svc.State) 宿主累计 CPU $(Cpu-Seconds $svc.ProcessId) 秒 | InventorySvc $((Get-InvSvc).State) | CompatTelRunner $($tel.Count) 个 累计 CPU $telCpu 秒"
        Add-Content -Path $monitorLog -Value $line -Encoding utf8
        Start-Sleep -Seconds 20
    }
}
else {
    Show-State '结束时'
    if (Test-Path $monitorPid) { Stop-Process -Id ([int](Get-Content $monitorPid)) -Force -ErrorAction SilentlyContinue }
    if (Test-Path $monitorLog) {
        $lines = @(Get-Content $monitorLog)
        $storRunning = @($lines | Where-Object { $_ -match 'StorSvc Running' }).Count
        $telPresent = @($lines | Where-Object { $_ -notmatch 'CompatTelRunner 0 个' }).Count
        $invRunning = @($lines | Where-Object { $_ -match 'InventorySvc Running' }).Count
        "监视汇总：共 $($lines.Count) 次采样；StorSvc 处于运行的 $storRunning 次；InventorySvc 处于运行的 $invRunning 次；有 CompatTelRunner 在运行的 $telPresent 次"
        $lines | ForEach-Object { "监视：$_" }
    }
    else { '监视汇总：没有监视记录' }
}
