// G-code parser for 3D preview
// Ported and adapted from https://github.com/xyz-tools/gcode-preview

export interface Segment {
    isTravel: boolean;
    coords: Float32Array;  // packed XYZ, pointCount*3 floats
    pointCount: number;
}

export interface LinePosition {
    segIdx: number;
    pointIdx: number;
}

export interface GCodeParseResult {
    segments: Segment[];
    lineIndex: LinePosition[];  // one entry per input line
}

interface State {
    x: number;
    y: number;
    z: number;
    e: number;
    absoluteE: boolean;
    units: 'mm' | 'in';
}

function parseLine(line: string): { gcode: string | null; params: Record<string, number> } {
    const cmd = (line.split(';')[0]).trim();
    if (!cmd) { return { gcode: null, params: {} }; }

    const tokens = cmd.split(/([a-zA-Z])/);
    const params: Record<string, number> = {};
    let gcode: string | null = null;

    // tokens[0] is text before first letter (usually '')
    // tokens[1,3,5,...] are letters, tokens[2,4,6,...] are number strings
    for (let i = 1; i + 1 < tokens.length; i += 2) {
        const letter = tokens[i].toLowerCase();
        const numStr = tokens[i + 1].trim();
        const val = parseFloat(numStr);
        if (!isNaN(val)) {
            params[letter] = val;
        }
        if (gcode === null) {
            gcode = letter + numStr; // e.g. 'g0', 'g1', 'g28', 'm82'
        }
    }

    return { gcode, params };
}

export async function parseGCode(lines: string[]): Promise<GCodeParseResult> {
    const state: State = { x: 0, y: 0, z: 0, e: 0, absoluteE: false, units: 'mm' };

    const finishedSegs: Segment[] = [];
    let currentPoints: number[] = [];
    let currentIsTravel = true;

    let lastPos: LinePosition = { segIdx: 0, pointIdx: 0 };
    const lineIndex: LinePosition[] = [];

    function finishSegment(): void {
        if (currentPoints.length >= 6) {
            finishedSegs.push({
                isTravel: currentIsTravel,
                coords: new Float32Array(currentPoints),
                pointCount: currentPoints.length / 3,
            });
        }
        currentPoints = [];
    }

    // Add a point to the current segment. If isTravel changes, finish the current
    // segment and start a new one beginning at the current state position.
    function addPoint(x: number, y: number, z: number, isTravel: boolean): void {
        if (currentPoints.length > 0 && isTravel !== currentIsTravel) {
            finishSegment();
        }
        if (currentPoints.length === 0) {
            currentIsTravel = isTravel;
            // Start new segment from current state position
            currentPoints.push(state.x, state.y, state.z);
        }
        currentPoints.push(x, y, z);
    }

    function getLastPos(): LinePosition {
        if (currentPoints.length === 0) { return lastPos; }
        return {
            segIdx: finishedSegs.length,
            pointIdx: currentPoints.length / 3 - 1,
        };
    }

    function handleLinearMove(params: Record<string, number>, isG0: boolean): void {
        // Skip zero-displacement moves (retraction/deretraction or feedrate only)
        if (params['x'] === undefined && params['y'] === undefined && params['z'] === undefined) {
            if (params['e'] !== undefined && state.absoluteE) {
                state.e = params['e'];
            }
            return;
        }

        const targetX = params['x'] ?? state.x;
        const targetY = params['y'] ?? state.y;
        const targetZ = params['z'] ?? state.z;

        let isTravel: boolean;
        if (isG0) {
            isTravel = true;
        } else {
            const eVal = params['e'];
            if (eVal === undefined) {
                isTravel = true;
            } else if (state.absoluteE) {
                isTravel = eVal <= state.e;
            } else {
                isTravel = eVal <= 0;
            }
        }

        addPoint(targetX, targetY, targetZ, isTravel);

        if (params['e'] !== undefined && state.absoluteE) {
            state.e = params['e'];
        }
        state.x = targetX;
        state.y = targetY;
        state.z = targetZ;
    }

    function handleArcMove(params: Record<string, number>, cw: boolean): void {
        const targetX = params['x'] ?? state.x;
        const targetY = params['y'] ?? state.y;
        const targetZ = params['z'] ?? state.z;
        const eVal = params['e'];

        let isTravel: boolean;
        if (eVal === undefined) {
            isTravel = true;
        } else if (state.absoluteE) {
            isTravel = eVal <= state.e;
        } else {
            isTravel = eVal <= 0;
        }

        let i = params['i'] ?? 0;
        let j = params['j'] ?? 0;
        const r = params['r'];

        // R mode: compute I/J from radius
        if (r !== undefined) {
            const deltaX = targetX - state.x;
            const deltaY = targetY - state.y;
            const minR = Math.sqrt(Math.pow(deltaX / 2, 2) + Math.pow(deltaY / 2, 2));
            const effectiveR = Math.max(Math.abs(r), minR);
            const dSquared = deltaX * deltaX + deltaY * deltaY;
            if (dSquared > 0) {
                const hSquared = effectiveR * effectiveR - dSquared / 4;
                let hDivD = Math.sqrt(Math.max(0, hSquared) / dSquared);
                if ((cw && r < 0) || (!cw && r > 0)) { hDivD = -hDivD; }
                i = deltaX / 2 + deltaY * hDivD;
                j = deltaY / 2 - deltaX * hDivD;
            }
        }

        const wholeCircle = state.x === targetX && state.y === targetY;
        const centerX = state.x + i;
        const centerY = state.y + j;
        const arcRadius = Math.sqrt(i * i + j * j);
        const arcCurrentAngle = Math.atan2(-j, -i);
        const finalTheta = Math.atan2(targetY - centerY, targetX - centerX);

        let totalArc: number;
        if (wholeCircle) {
            totalArc = 2 * Math.PI;
        } else {
            totalArc = cw ? arcCurrentAngle - finalTheta : finalTheta - arcCurrentAngle;
            if (totalArc < 0) { totalArc += 2 * Math.PI; }
        }

        let totalSegments = (arcRadius * totalArc) / 0.5;
        if (state.units === 'in') { totalSegments *= 25; }
        totalSegments = Math.max(1, Math.ceil(totalSegments));

        const arcAngleIncrement = (totalArc / totalSegments) * (cw ? -1 : 1);
        const zStep = (targetZ - state.z) / totalSegments;

        let currentAngle = arcCurrentAngle;
        let pz = state.z;

        for (let moveIdx = 0; moveIdx < totalSegments - 1; moveIdx++) {
            currentAngle += arcAngleIncrement;
            const px = centerX + arcRadius * Math.cos(currentAngle);
            const py = centerY + arcRadius * Math.sin(currentAngle);
            pz += zStep;
            addPoint(px, py, pz, isTravel);
        }

        // Final point at exact target
        addPoint(targetX, targetY, targetZ, isTravel);

        if (params['e'] !== undefined && state.absoluteE) {
            state.e = params['e'];
        }
        state.x = targetX;
        state.y = targetY;
        state.z = targetZ;
    }

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        // Yield to event loop every 2000 lines to avoid blocking
        if (lineNum > 0 && lineNum % 2000 === 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        const { gcode, params } = parseLine(lines[lineNum]);

        if (gcode !== null) {
            switch (gcode) {
                case 'g0':
                    handleLinearMove(params, true);
                    break;
                case 'g1':
                    handleLinearMove(params, false);
                    break;
                case 'g2':
                    handleArcMove(params, true);
                    break;
                case 'g3':
                    handleArcMove(params, false);
                    break;
                case 'g20':
                    state.units = 'in';
                    break;
                case 'g21':
                    state.units = 'mm';
                    break;
                case 'g28':
                    state.x = 0;
                    state.y = 0;
                    state.z = 0;
                    break;
                case 'm82':
                    state.absoluteE = true;
                    break;
                case 'm83':
                    state.absoluteE = false;
                    break;
            }
        }

        lastPos = getLastPos();
        lineIndex.push({ ...lastPos });
    }

    // Finish any remaining in-progress segment
    finishSegment();

    return { segments: finishedSegs, lineIndex };
}
