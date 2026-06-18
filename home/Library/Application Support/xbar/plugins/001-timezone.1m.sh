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

calendar() {
  local year=$1
  local month=$2
  local prefix=$3
  local today=$4
  local first_dow days_in_month

  first_dow=$(date -j -f "%Y-%m-%d" "${year}-$(printf '%02d' "$month")-01" +%w)
  days_in_month=$(date -j -v+1m -v1d -v-1d -f "%Y-%m-%d" "${year}-$(printf '%02d' "$month")-01" +%d)

  echo "$(date -j -f "%Y-%m-%d" "${year}-$(printf '%02d' "$month")-01" +%B) ${year}"
  echo "${prefix} Su  Mo  Tu  We  Th  Fr  Sa | trim=false font=courier"

  local week=""
  for ((i = 0; i < first_dow; i++)); do
    week="${week}    "
  done

  for ((day = 1; day <= days_in_month; day++)); do
    if [ "$today" -gt 0 ] && [ "$day" -eq "$today" ]; then
      week="${week}$(printf "(%2d)" "$day")"
    else
      week="${week}$(printf " %2d " "$day")"
    fi

    if [ $(((first_dow + day) % 7)) -eq 0 ] || [ "$day" -eq "$days_in_month" ]; then
      while [ $(((first_dow + day) % 7)) -ne 0 ]; do
        week="${week}    "
        ((day++))
      done
      echo "${prefix}${week} | trim=false font=courier"
      week=""
    fi
  done
}

year=$(date +%Y)
month=$(date +%-m)
today=$(date +%-e)

# Previous month
if [ "$month" -eq 1 ]; then
  prev_year=$((year - 1))
  prev_month=12
else
  prev_year=$year
  prev_month=$((month - 1))
fi

# Next month
if [ "$month" -eq 12 ]; then
  next_year=$((year + 1))
  next_month=1
else
  next_year=$year
  next_month=$((month + 1))
fi

calendar "$prev_year" "$prev_month" "--" 0
echo "---"
calendar "$year" "$month" "" "$today"
echo "---"
calendar "$next_year" "$next_month" "--" 0

echo "---"
echo "Johannesburg | terminal=false"
echo "🇬🇧 ${LONDON_TIME} London | terminal=false"
echo "🇦🇺 ${MELBOURNE_TIME} Melbourne | terminal=false"
echo "---"
echo "Refresh | refresh=true"
