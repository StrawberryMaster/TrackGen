function getIbtracsShape(initials) {
    const i = initials.trim().toUpperCase();

    if (["TD", "TS", "HU", "ST", "TY", "NR", "MX"].includes(i)) {
        return "circle";
    } else if (["SS"].includes(i)) {
        return "square";
    } else if (["DB", "ET", "DS"].includes(i)) {
        return "triangle";
    } else {
        console.error("Unknown IBTRACS initials: " + i);
    }
}

/**
 * Parses a coordinate value and returns a formatted string.
 * We insert a decimal point one place from the end of the numeric part,
 * and append the direction character. For example, "1234E" becomes "123.4E".
 * 
 * @param {string} value - The coordinate value to parse.
 * @returns {string} The formatted coordinate value.
 */
function parseCoord(value) {
    const len = value.length;
    const direction = value.charAt(len - 1); // Extract the last character (E, W, N, S)
    const numericValue = value.substring(0, len - 1);

    const formattedValue = numericValue.length > 1
        ? numericValue.slice(0, -1) + '.' + numericValue.slice(-1)
        : '0.' + numericValue;

    return parseFloat(formattedValue).toFixed(1) + direction;
}

function parseIbtracs(data) {
    const lines = data.split("\n");

    const parsed = [];
    lines.forEach(line => {
        if (line !== "") {
            if (line.trim() === '') {
                return;
            }

            const cols = line.split(",");

            const wmo_wind = Number(cols[8]);
            const usa_wind = cols[21] ? Number(cols[21]) : NaN;

            const max_wind = isNaN(usa_wind) ? wmo_wind : Math.max(wmo_wind, usa_wind);

            parsed.push(
                {
                    name: cols[0],
                    shape: getIbtracsShape(cols[10]),
                    category: speedToCat(max_wind),
                    speed: max_wind,
                    latitude: parseCoord(cols[6].trim()),
                    longitude: parseCoord(cols[7].trim())
                }
            );
        }
    });

    return parsed;
}
