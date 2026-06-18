#!/bin/bash

# <xbar.title>South Africa Time</xbar.title>
# <xbar.version>v0.0.1</xbar.version>
# <xbar.author>Larry Botha</xbar.author>
# <xbar.desc>Shows the current time in South Africa, updating every minute.</xbar.desc>
# <xbar.dependencies>bash,date</xbar.dependencies>

timezones=(
  "Africa/Johannesburg:🇿🇦:Johannesburg"
  "Europe/London:🇬🇧:London"
  "Australia/Melbourne:🇦🇺:Melbourne"
)

for tz in "${timezones[@]}"; do
  IFS=: read -r zone flag city <<<"$tz"
  times+=("$(TZ="$zone" date +"%H:%M")")
  flags+=("$flag")
  cities+=("$city")
done

echo "${times[0]}"
echo "---"

#######################################
# Render a calendar for the given month.
# Globals:
#   None
# Arguments:
#   $1: YYYY-MM-DD, any day in the target month
#   $2: xbar prefix ("" for top-level, "--" for dropdown)
# Outputs:
#   Month header and calendar lines to stdout
# Returns:
#   0
#######################################
calendar() {
  local ymd=$1 prefix=$2
  local day_of_week days_in_month today_day year
  day_of_week=$(date -j -f "%Y-%m-%d" "$ymd" +%w)
  days_in_month=$(date -j -v+1m -v1d -v-1d -f "%Y-%m-%d" "$ymd" +%d)
  year=$(date -j -f "%Y-%m-%d" "$ymd" +%Y)

  if [ "$(date -j -f "%Y-%m-%d" "$ymd" +%Y-%m)" = "$(date +%Y-%m)" ]; then
    today_day=$(date +%-e)
  else
    today_day=0
  fi

  echo "$(date -j -f "%Y-%m-%d" "$ymd" +%B) ${year}"
  echo "${prefix} Su  Mo  Tu  We  Th  Fr  Sa | trim=false font=courier"

  local w=""

  for ((i = 0; i < day_of_week; i++)); do w="${w}    "; done

  for ((d = 1; d <= days_in_month; d++)); do
    if [ "$d" -eq "$today_day" ]; then
      w="${w}$(printf "(%2d)" "$d")"
    else w="${w}$(printf " %2d " "$d")"; fi

    if [ $(((day_of_week + d) % 7)) -eq 0 ] || [ "$d" -eq "$days_in_month" ]; then
      while [ $(((day_of_week + d) % 7)) -ne 0 ]; do
        w="${w}    "
        ((d++))
      done
      echo "${prefix}${w} | trim=false font=courier"
      w=""
    fi
  done
}

ymd=$(date +%Y-%m-01)
calendar "$(date -j -v-1m -f "%Y-%m-%d" "$ymd" +%Y-%m-01)" "--"
echo "---"
calendar "$ymd" ""
echo "---"
calendar "$(date -j -v+1m -f "%Y-%m-%d" "$ymd" +%Y-%m-01)" "--"

echo "---"
for i in "${!timezones[@]}"; do
  echo "${flags[$i]} ${times[$i]} ${cities[$i]} | terminal=false"
done
echo "---"
echo "Refresh | refresh=true"
