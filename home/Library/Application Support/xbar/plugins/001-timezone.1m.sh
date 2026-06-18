#!/bin/bash

# <xbar.title>South Africa Time</xbar.title>
# <xbar.version>v0.0.1</xbar.version>
# <xbar.author>Larry Botha</xbar.author>
# <xbar.desc>Shows the current time in South Africa, updating every minute.</xbar.desc>
# <xbar.dependencies>bash,date</xbar.dependencies>

SA_TIME=$(TZ="Africa/Johannesburg" date +"%H:%M")
LONDON_TIME=$(TZ="Europe/London" date +"%H:%M")
MELBOURNE_TIME=$(TZ="Australia/Melbourne" date +"%H:%M")

echo "$SA_TIME"
echo "---"

today=$(date +%-e)
first_dow=$(date -j -f "%Y-%m-%d" "$(date +%Y-%m)-01" +%w)
days_in_month=$(date -j -v+1m -v1d -v-1d -f "%Y-%m-%d" "$(date +%Y-%m)-01" +%d)

echo "$(date +%B) $(date +%Y)"
echo " Su  Mo  Tu  We  Th  Fr  Sa | trim=false font=courier"

week=""
for ((i = 0; i < first_dow; i++)); do
  week="${week}    "
done

for ((day = 1; day <= days_in_month; day++)); do
  if [ "$day" -eq "$today" ]; then
    week="${week}$(printf "(%2d)" "$day")"
  else
    week="${week}$(printf " %2d " "$day")"
  fi

  if [ $(((first_dow + day) % 7)) -eq 0 ] || [ "$day" -eq "$days_in_month" ]; then
    while [ $(((first_dow + day) % 7)) -ne 0 ]; do
      week="${week}    "
      ((day++))
    done
    echo "$week | trim=false font=courier"
    week=""
  fi
done

echo "---"
echo "Johannesburg | terminal=false"
echo "🇬🇧 ${LONDON_TIME} London | terminal=false"
echo "🇦🇺 ${MELBOURNE_TIME} Melbourne | terminal=false"
echo "---"
echo "Refresh | refresh=true"
