import { Direction } from './Direction.js';
import { getRandomInt } from './Random.js';

export default class Wilson
{
    get largeur() { return this._largeur; }
    get longeur() { return this._longeur; }
    get hauteur() { return this._hauteur; }

    get direction() { return this._direction; }
    
    constructor(largeur,longeur,hauteur)
    {
        this._largeur = largeur;
        this._longeur = longeur;
        this._hauteur = hauteur;
        this._maze = [];
        for (var z = 0; z < hauteur; z++)
        {
            this._maze[z] = [];
            for (var y = 0; y < longeur; y++)
            {
                this._maze[z][y] = [];
            }
        }
        this._doMaze();
    }

    _doMaze()
    {
        var key = (z, y, x) => `${z},${y},${x}`;

        var allUnvisitedCells = [];
        var allVisitedCells = new Map();
        for (var z = 0; z < this.hauteur; z++)
        {
            for (var y = 0; y < this.longeur; y++)
            {
                for (var x = 0; x < this.largeur; x++)
                {
                    allUnvisitedCells.push([z, y, x]);
                }
            }
        }

        while (allUnvisitedCells.length > 0)
        {
            var thisPathVisitedCells = new Map();
            var cellNumber = getRandomInt(allUnvisitedCells.length);
            var thisCell = allUnvisitedCells[cellNumber];

            var keepGoing = true;
            while (keepGoing)
            {
                var z = thisCell[0];
                var y = thisCell[1];
                var x = thisCell[2];
                allVisitedCells.set(key(z, y, x), true);
                var idx = allUnvisitedCells.findIndex(c => c[0] === z && c[1] === y && c[2] === x);
                allUnvisitedCells.splice(idx, 1);
                thisPathVisitedCells.set(key(z, y, x), true);
                var choices = [];
                if ((z != this.hauteur - 1) && (this._maze[z][y][x] & Direction.Down) == 0) choices.push(Direction.Down);
                if ((z != 0) && (this._maze[z][y][x] & Direction.Up) == 0) choices.push(Direction.Up);
                if ((y != this.longeur - 1) && (this._maze[z][y][x] & Direction.South) == 0) choices.push(Direction.South);
                if ((y != 0) && (this._maze[z][y][x] & Direction.North) == 0) choices.push(Direction.North);
                if ((x != this.largeur - 1) && (this._maze[z][y][x] & Direction.East) == 0) choices.push(Direction.East);
                if ((x != 0) && (this._maze[z][y][x] & Direction.West) == 0) choices.push(Direction.West);

                var foundADirection = false;
                while (choices.length != 0)
                {
                    var choiceIndex = getRandomInt(choices.length);
                    var direction = choices[choiceIndex];
                    choices.splice(choiceIndex, 1);
                    var nextX = x;
                    var nextY = y;
                    var nextZ = z;
                    if (direction == Direction.Up) nextZ = nextZ - 1;
                    if (direction == Direction.Down) nextZ = nextZ + 1;
                    if (direction == Direction.North) nextY = nextY - 1;
                    if (direction == Direction.South) nextY = nextY + 1;
                    if (direction == Direction.West) nextX = nextX - 1;
                    if (direction == Direction.East) nextX = nextX + 1;
                    var nextLocation = [nextZ, nextY, nextX];
                    if (thisPathVisitedCells.has(key(nextZ, nextY, nextX))) continue;
                    foundADirection = true;
                    this._maze[z][y][x] |= direction;
                    thisCell = nextLocation;
                    if (direction == Direction.Up) this._maze[nextZ][nextY][nextX] |= Direction.Down;
                    if (direction == Direction.Down) this._maze[nextZ][nextY][nextX] |= Direction.Up;
                    if (direction == Direction.North) this._maze[nextZ][nextY][nextX] |= Direction.South;
                    if (direction == Direction.South) this._maze[nextZ][nextY][nextX] |= Direction.North;
                    if (direction == Direction.East) this._maze[nextZ][nextY][nextX] |= Direction.West;
                    if (direction == Direction.West) this._maze[nextZ][nextY][nextX] |= Direction.East;
                    if (allVisitedCells.has(key(nextZ, nextY, nextX))) keepGoing = false;
                    break;
                }

                if (!foundADirection) keepGoing = false;
            }
        }
    }
}
