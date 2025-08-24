function getHurdatShape(initials) {
    const i = initials.toUpperCase();

    if (["TD", "TS", "HU", "TY", "ST", "TC"].includes(i)) {
        return "circle";
    } else if (["SD", "SS"].includes(i)) {
        return "square";
    } else if (["EX", "LO", "DB", "WV", "MD"].includes(i)) {
        return "triangle";
    } else {
        console.error("Unknown HURDAT shape: " + i);
    }
}

function parseHurdat(data) {
    const lines = data.split("\n");

    const parsed = [];
    let uniqueId = "";
    lines.forEach(line => {
        if (line.trim() === '') {
            return;
        }
        
        const cols = line.split(", ");

        if (cols.length === 3) {
            uniqueId = cols[0];
        } else {
            parsed.push(
                {
                    name: uniqueId,
                    shape: getHurdatShape(cols[3]),
                    category: speedToCat(Number(cols[6])),
                    speed: Number(cols[6]),
                    latitude: cols[4],
                    longitude: cols[5]
                }
            )
        }
    });

    return parsed
}
