# remote-control-loop.ps1
# Maintient Claude Remote Control actif en permanence POUR CE PROJET.
# Lance par le dossier Demarrage (voir installer-remote-control.ps1).
# Si la session s'arrete (timeout reseau, veille, crash...), elle est relancee.
#
# Le PID de la session en cours est ecrit dans .remote-control.pid pour que
# le desinstallateur puisse arreter UNIQUEMENT ce projet.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

# --- Nom de session : UNIQUE a ce projet (evite la confusion avec d'autres) ---
$SessionName = "CRYPTONAUTS"

# --- Localiser claude.exe ---
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Claude\claude.exe"
    if (Test-Path $candidate) { $claude = $candidate }
}
if (-not $claude) { $claude = "claude" }

$pidFile = Join-Path $PSScriptRoot ".remote-control.pid"

# Session remote-control FRAICHE, autonomie totale, SANS --continue.
# IMPORTANT : --continue reprend une ancienne conversation LOCALE et n'etablit
# PAS la session distante visible sur claude.ai/code. C'est pour ca que les
# projets lances avec --continue ne montraient aucune session. On l'enleve.
#
# --- UUID FIXE : evite l'empilement de sessions fantomes sur mobile ----------
# Sans --session-id, claude genere un UUID NEUF a chaque relance -> chaque
# relance cree une NOUVELLE entree "CRYPTONAUTS" sur le mobile (fantomes qui
# s'empilent = "tout en double"). En epinglant un UUID STABLE, chaque relance
# reutilise LE MEME slot => une seule entree recyclee cote mobile.
# On reste en "session fraiche" : juste avant chaque lancement on efface
# l'historique persistant de CET UUID (voir la boucle), donc pas de reprise de
# vieille conversation (ce qui rendait la session invisible avec --continue).
$RemoteSessionId = "981f964e-2cb0-4ca3-b931-f55d7edf5134"
$projectStore    = Join-Path $env:USERPROFILE ".claude\projects\C--Users-vince-CRYPTONAUTS"
$argsFresh = @("--remote-control", $SessionName, "--session-id", $RemoteSessionId, "--dangerously-skip-permissions")

# PID de la boucle (le desinstallateur cible aussi par le mot "Cryptonauts")
Set-Content -Path $pidFile -Value $PID -Encoding ASCII

# --- Watchdog : auto-repare un claude FIGE (vivant mais 0 connexion Anthropic) ---
# Cas vecu le 2026-06-24 : au boot, claude peut rester bloque AVANT d'ouvrir la
# connexion remote (onboarding/race reseau). Resultat : invisible sur mobile, et
# la boucle ci-dessous ne le relance PAS car il ne se TERMINE pas (il reste fige).
# Le watchdog le tue apres ~40 s sans connexion etablie vers Anthropic -> la
# boucle le relance alors frais. Tourne dans un job separe, parametre par $SessionName.
$logFile = Join-Path $PSScriptRoot "remote-control-loop.log"

# --- DIAG "relance toute seule" (2026-09-01) : trace CHAQUE (re)demarrage de la
# loop -> heure + PID + PID/nom du PARENT. Task Scheduler restart => parent
# svchost/taskhostw ; lancement manuel => powershell/explorer. Tout l'exterieur
# (reboot/veille/logon/batterie/watchdog/crash) ayant ete elimine le 2026-09-01,
# seule cette ligne dira POURQUOI/QUI relance au prochain evenement.
$__ppid  = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId
$__pname = if ($__ppid) { (Get-CimInstance Win32_Process -Filter "ProcessId=$__ppid" -ErrorAction SilentlyContinue).Name } else { '?' }
"$(Get-Date -Format s) LOOP START: $SessionName PID $PID <- parent PID $__ppid ($__pname)" | Out-File -FilePath $logFile -Append -Encoding utf8

Get-Job -Name "wd-$SessionName" -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
Start-Job -Name "wd-$SessionName" -ArgumentList $SessionName, $logFile, $PID -ScriptBlock {
    param($session, $log, $myLoopPid)
    $strikes = 0
    $connectedPid = 0   # PID d'un claude ayant connecte AU MOINS une fois
    $hb = 0             # DIAG 2026-09-07 : heartbeat ~5 min -> derniere ligne HEARTBEAT ~= heure de mort de la loop
    while ($true) {
        Start-Sleep -Seconds 20
        $hb++
        if ($hb -ge 15) { $hb = 0; "$(Get-Date -Format s) HEARTBEAT: $session loop PID $myLoopPid alive" | Out-File -FilePath $log -Append -Encoding utf8 }

        # --- SINGLETON PERMANENT : la loop la plus ANCIENNE gagne -----------
        # Ordre total (StartTime puis PID) => convergence deterministe vers UNE
        # seule loop, sans course d'entre-tuerie. Si JE suis la loop en trop
        # (une autre est plus ancienne), je retire MON claude puis MOI-meme.
        # Corrige le cas "deux loops se disputent le nom -> relais mobile jamais
        # monte -> session invisible" (BETSFIX, 2026-07-17).
        $loops = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
                   Where-Object { $_.CommandLine -match "$session\\remote-control-loop" })
        if ($loops.Count -gt 1) {
            $mine = $loops | Where-Object { $_.ProcessId -eq $myLoopPid } | Select-Object -First 1
            if ($mine) {
                $older = $loops | Where-Object {
                    $_.ProcessId -ne $myLoopPid -and (
                        ($_.CreationDate -lt $mine.CreationDate) -or
                        ($_.CreationDate -eq $mine.CreationDate -and $_.ProcessId -lt $myLoopPid)
                    )
                }
                if ($older) {
                    "$(Get-Date -Format s) SINGLETON: loop $session en double (moi PID $myLoopPid, plus jeune) -> auto-retrait" | Out-File -FilePath $log -Append -Encoding utf8
                    Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
                        Where-Object { $_.CommandLine -match "remote-control $session" -and $_.ParentProcessId -eq $myLoopPid } |
                        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    Stop-Process -Id $myLoopPid -Force -ErrorAction SilentlyContinue
                    return
                }
            }
        }

        $p = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
             Where-Object { $_.CommandLine -match "remote-control $session" } |
             Select-Object -First 1
        if (-not $p) { $strikes = 0; continue }
        $conns = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Established -ErrorAction SilentlyContinue |
                   Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1' })
        # Sante = au moins UNE connexion etablie vers Anthropic.
        # NB (2026-07-27) : on ne tue PLUS sur "tempete / relais absent". Une
        # session en veille NON regardee ne monte jamais son relais mobile :
        # c'est son etat NORMAL, pas une panne. La tuer relancait une session
        # toutes les ~5 min (fantomes empiles sur mobile) sans jamais remonter
        # le relais -- il se monte quand tu OUVRES la session sur mobile. On ne
        # tue QUE le claude qui n'a JAMAIS connecte depuis son lancement.
        # Une connexion etablie => la session a REUSSI a s'ouvrir : on marque ce
        # PID comme deja-connecte et on la considere saine.
        if ($conns.Count -gt 0) { $connectedPid = $p.ProcessId; $strikes = 0; continue }
        # 0 connexion mais ce PID a DEJA connecte => session simplement EN VEILLE
        # / non regardee sur mobile (le relais ne monte qu'a l'ouverture mobile,
        # le long-poll API se met en idle). Etat NORMAL : NE PAS tuer, sinon
        # churn/relaunch en boucle (fantomes mobile, "ne demarre jamais"). On ne
        # tue que le claude fige a l'onboarding (jamais connecte).
        if ($p.ProcessId -eq $connectedPid) { $strikes = 0; continue }
        $strikes++
        if ($strikes -ge 9) {
            "$(Get-Date -Format s) WATCHDOG: claude $session fige (jamais connecte ~180s, PID $($p.ProcessId)) -> kill" | Out-File -FilePath $log -Append -Encoding utf8
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            $strikes = 0
        }
    }
} | Out-Null

while ($true) {
    try {
        # CONTINUITE DE CONVERSATION (2026-09-08) : on N'EFFACE PLUS l'historique
        # de cet UUID avant lancement. En reutilisant le MEME --session-id sans
        # nettoyer le store, claude REPREND la conversation existante (historique
        # intact) au lieu d'en ouvrir une vierge -> tu peux continuer la meme
        # discussion pendant des jours, meme apres les relances au logon.
        # Doc Claude Code : --remote-control + --session-id sur un id deja present
        # = reprise (et le canal mobile se remonte). L'ancienne version effacait
        # le store a chaque lancement (session fraiche) : c'etait la cause du
        # "ca change de conversation tous les jours". L'erreur "Session ID already
        # in use" ne se produit QUE si un autre claude avec ce meme id tourne
        # ENCORE au lancement -- pas notre cas (l'ancien est mort avant la relance
        # via logon/watchdog/crash). $projectStore reste defini pour diag.
        $null = $projectStore

        # On appelle claude DIRECTEMENT (operateur &), pas via Start-Process
        # -WindowStyle Hidden. claude a besoin d'heriter de la console (cachee)
        # de ce PowerShell pour le mode remote-control. Avec
        # Start-Process detache, claude perd sa console et ressort aussitot.
        & $claude @argsFresh
    } catch {
        # crash/timeout reseau : on relance apres une courte pause
    }
    Start-Sleep -Seconds 3
}

