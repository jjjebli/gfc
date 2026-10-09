#!/bin/bash
# run_one.sh MODEL ARM SCENARIO REP  — fixture derived from scenario+rep
M=$1; ARM=$2; SC=$3; REP=$4
B=~/gfc-bench
mkdir -p "$B/results/$M/$ARM"
case "$SC" in
  s1|s2|s3) F="$B/fixtures/big_${SC}_${REP}.txt" ;;
  s5)       F="$B/fixtures/small_${REP}.txt" ;;
  *)        echo "unknown scenario $SC"; exit 2 ;;
esac
P=$(sed "s|__FILE__|$F|g" "$B/prompts/$SC.txt")
opencode run -m "opencode/$M" --format json "$P" > "$B/results/$M/$ARM/${SC}_${REP}.jsonl" 2>/dev/null
echo "done model=$M arm=$ARM sc=$SC rep=$REP exit=$?"
