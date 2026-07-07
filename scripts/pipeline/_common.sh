# scripts/pipeline/*.sh 的共用 helper。source 用，不直接執行。
# 慣例：exit 3 = 用法/設定錯誤（無證據語意），比照 scripts/diff-check.sh。

# 受信任的 comment 作者關聯（GitHub authorAssociation）：
#   OWNER=repo 擁有者、MEMBER=org 成員、COLLABORATOR=被加入的協作者。
#   其餘（CONTRIBUTOR/NONE/FIRST_TIME*）一律視為 untrusted，不進 agent context。
PIPELINE_TRUSTED_ASSOC="OWNER MEMBER COLLABORATOR"
# 簽核（APPROVE-DESIGN / ACCEPT-EXCEPTION）僅 OWNER 有效——repo 公開，任何帳號皆可留言。
PIPELINE_SIGNOFF_ASSOC="OWNER"

# gh 指令可覆寫：測試餵 fake gh，正式跑用真實 gh。
PIPELINE_GH="${PIPELINE_GH:-gh}"
# 每個外部呼叫的預設 timeout（秒）。
PIPELINE_TIMEOUT="${PIPELINE_TIMEOUT:-30}"

pipeline_die() { echo "❌ usage/config: $*" >&2; exit 3; }

pipeline_need() { command -v "$1" >/dev/null 2>&1 || pipeline_die "缺指令: $1"; }

# 可移植 timeout：timeout → gtimeout → perl fork+alarm。
# 逾時回傳 124（比照 GNU timeout）。perl 必須 fork 後在子行程 exec——
# 直接 exec 會替換整個 process image、連 alarm handler 一起丟掉。
pipeline_run_to() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return; fi
  perl -e '
    my $s = shift @ARGV;
    my $pid = fork();
    exit 127 if !defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "TERM", $pid; };
    alarm $s;
    waitpid($pid, 0);
    my $st = $?;
    exit(($st & 127) ? 124 : ($st >> 8));
  ' "$secs" "$@"
}

# authorAssociation 是否落在某個受信任集合（空白分隔）。
pipeline_assoc_in() {
  local assoc="$1" set="$2" a
  for a in $set; do [[ "$assoc" == "$a" ]] && return 0; done
  return 1
}
