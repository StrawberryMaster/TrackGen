const WIND_SPEED_THRESHOLDS = {
    TD: 34,
    TS: 64,
    C1: 83,
    C2: 96,
    C3: 113,
    C4: 137
};
const MS_TO_KNOTS = 1.943844;

function windSpeedToCategory(speed) {
    const knots = speed * MS_TO_KNOTS;

    for (const [category, threshold] of Object.entries(WIND_SPEED_THRESHOLDS)) {
        if (knots < threshold) return category;
    }
    return 'C5';
}

function getStormsShape(category) {
    if (['TD', 'TS'].includes(category) || category.startsWith('C')) {
        return 'circle';
    }
    console.error("Unknown STORMS category shape: " + category);
    return 'triangle';
}

function formatLatitude(lat) {
    return `${Math.abs(lat).toFixed(1)}${lat < 0 ? 'S' : 'N'}`;
}

function formatLongitude(lon) {
    const adjustedLon = lon > 180 ? lon - 360 : lon;
    return `${Math.abs(adjustedLon).toFixed(1)}${adjustedLon < 0 ? 'W' : 'E'}`;
}

function parseStorms(data) {
    const lines = data.trim().split('\n');
    const parsed = [];

    lines.forEach(line => {
        if (line.trim() === '') {
            return;
        }
        
        const cols = line.trim().split(/[\s,]+/).filter(col => col.length > 0);

        if (cols.length >= 13) {
            const tcNumber = cols[2].padStart(2, '0');
            const windSpeedKnots = parseFloat(cols[8]) * MS_TO_KNOTS;
            const category = windSpeedToCategory(parseFloat(cols[9]));

            parsed.push({
                name: tcNumber,
                shape: getStormsShape(category),
                category: speedToCat(windSpeedKnots),
                speed: windSpeedKnots,
                latitude: formatLatitude(parseFloat(cols[5])),
                longitude: formatLongitude(parseFloat(cols[6])),
            });
        }
    });

    return parsed;
}