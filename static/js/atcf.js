function getAtcfShape(initials) {
    const i = initials.toUpperCase();

    if (["TY", "TD", "TS", "ST", "TC", "HU", "XX"].includes(i)) {
        return "circle";
    } else if (["SD", "SS"].includes(i)) {
        return "square";
    } else if (["EX", "MD", "IN", "DS", "LO", "WV", "ET", "DB"].includes(i)) {
        return "triangle";
    } else {
        console.error("Unknown ATCF initials: " + i);
    }
}

function parseAtcf(data) {
    const lines = data.split("\n");

    const parsed = [];
    lines.forEach(line => {
        if (line.trim() === '') {
            return;
        }

        const cols = line.split(", ");

        parsed.push(
            {
                name: cols[1],
                shape: getAtcfShape(cols[10]),
                category: speedToCat(Number(cols[8])),
                speed: Number(cols[8]),
                latitude: cols[6].slice(0, -2) + "." + cols[6].slice(-2),
                longitude: cols[7].slice(0, -2) + "." + cols[7].slice(-2)
            }
        )
    });

    return parsed;
}
