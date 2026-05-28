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
echo "Johannesburg | terminal=false"
echo "🇬🇧 ${LONDON_TIME} London | terminal=false"
echo "🇦🇺 ${MELBOURNE_TIME} Melbourne | terminal=false"
echo "---"
echo "Refresh | refresh=true"
