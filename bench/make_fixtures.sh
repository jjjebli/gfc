#!/bin/bash
# regenerate pristine fixtures (s2 runs mutate their file via edit tool)
cd ~/gfc-bench
for i in 1 2 3; do
  seq 1 2000 | awk '{printf "line %04d\n", $1}' > fixtures/big_s1_$i.txt
  seq 1 2000 | awk '{printf "line %04d\n", $1}' > fixtures/big_s2_$i.txt
  seq 1 2000 | awk '{printf "line %04d\n", $1}' > fixtures/big_s3_$i.txt
  seq 1 8 | awk '{printf "small line %d\n", $1}' > fixtures/small_$i.txt
done
echo "fixtures regenerated"
