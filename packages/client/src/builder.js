// --- Écran: créer une partie ---

export class Builder {
    static get EULERS_CONSTANT() {
        return 6.25;
    }

    constructor($,sessionToken,eventSink) {
        this._createGame = true;
        this._builderDialogEl = $('builder-dialog');
        this._builderTitle = $('builder-title');
        this._gameNameInput = $('game-name');
        this._gamePasswordInput = $('game-password');
        this._humanCountInput = $('human-count');
        this._aiCountInput = $('ai-count');
        this._humanCountValueEl = $('human-count-value');
        this._aiCountValueEl = $('ai-count-value');
        this._mazeWidthInput = $('maze-width');
        this._mazeLengthInput = $('maze-length');
        this._mazeHeightInput = $('maze-height');
        this._mazeWidthValueEl = $('maze-width-value');
        this._mazeLengthValueEl = $('maze-length-value');
        this._mazeHeightValueEl = $('maze-height-value');
        this._mazeSizeSummaryEl = $('maze-size-summary');
        this._mazeSizeErrorEl = $('maze-size-error');
        this._createGameButton = $('create-game-button');
        this._cancelCreateGameButton = $('builder-cancel-button');
        this._scoreTargetInput = $('score-target');
        this._scoreTargetValueEl = $('score-target-value');
        this._unlimitedTimeCheckbox = $('unlimited-time-checkbox');
        this._timeLimitRow = $('time-limit-row');
        this._timeLimitInput = $('time-limit');
        this._timeLimitValueEl = $('time-limit-value');


        this._sessionToken = sessionToken;
        this._eventSink = eventSink;
        this._$ = $;
        this._doListeners();
    }

    isVisible() {
        return this._builderDialogEl.style.display !== 'none'
    }

    hide() {
        this._builderDialogEl.style.display = 'none';
    }

    show(createGame,playerProfile) {
        console.log(`builder.show ${createGame}; ${playerProfile}`);
        this._createGame = createGame;
        this._playerProfile = playerProfile;
        this._createGameButton.textContent = createGame ? 'Create Game' : 'Edit Game';
        this._builderTitle.textContent = createGame ? 'Create Game' : 'Edit Game';
        this._builderDialogEl.style.display = 'block';
    }

    _updateCreateButtonState() {
        const width = parseInt(this._mazeWidthInput.value, 10);
        const length = parseInt(this._mazeLengthInput.value, 10);
        const height = parseInt(this._mazeHeightInput.value, 10);
        const actualCells = width * length * height;
        const total = this.currentTotalPlayers();
        const tooCramped = actualCells < total;
        const nameEmpty = this._gameNameInput.value.trim().length === 0;

        this._createGameButton.disabled = tooCramped || nameEmpty;
    }

    _updateMazeSizeSummary() {
        const total = this.currentTotalPlayers();
        const recommendedCells = Math.floor(total * Builder.EULERS_CONSTANT);

        const width = parseInt(this._mazeWidthInput.value, 10);
        const length = parseInt(this._mazeLengthInput.value, 10);
        const height = parseInt(this._mazeHeightInput.value, 10);
        const actualCells = width * length * height;

        this._mazeWidthValueEl.textContent = width;
        this._mazeLengthValueEl.textContent = length;
        this._mazeHeightValueEl.textContent = height;

        this._mazeSizeSummaryEl.textContent =
            `Maze size: ${width} x ${length} x ${height} = ${actualCells} cells. ` +
            `Recommended size is ${recommendedCells} cells (~${Builder.EULERS_CONSTANT}/player) for ${total} player${total === 1 ? '' : 's'}.`;

        const tooCramped = actualCells < total;
        if (tooCramped) {
            this._mazeSizeErrorEl.textContent =
                `Too cramped: ${actualCells} cells for ${total} players is below the 1 cell/player minimum. Increase maze size or reduce player count.`;
            this._mazeSizeErrorEl.style.display = 'block';
        } else {
            this._mazeSizeErrorEl.style.display = 'none';
        }

        this._updateCreateButtonState();
    }

    _doListeners() {
        this._gameNameInput.addEventListener('input', () => { this._updateCreateButtonState() });

        this._humanCountInput.addEventListener('input', () => {
            this._humanCountValueEl.textContent = this._humanCountInput.value;
            if (this.currentTotalPlayers() > 16) {
                this._aiCountInput.value = Math.max(0, 16 - parseInt(this._humanCountInput.value, 10));
                this._aiCountValueEl.textContent = this._aiCountInput.value;
            }
            this._updateMazeSizeSummary();
        });

        this._aiCountInput.addEventListener('input', () => {
            this._aiCountValueEl.textContent = this._aiCountInput.value;
            if (this.currentTotalPlayers() > 16) {
                this._humanCountInput.value = Math.max(1, 16 - parseInt(this._aiCountInput.value, 10));
                this._humanCountValueEl.textContent = this._humanCountInput.value;
            }
            this._updateMazeSizeSummary();
        });

        this._mazeWidthInput.addEventListener('input', () => { this._updateMazeSizeSummary() });
        this._mazeLengthInput.addEventListener('input', () => { this._updateMazeSizeSummary() });
        this._mazeHeightInput.addEventListener('input', () => { this._updateMazeSizeSummary() });

        this._scoreTargetInput.addEventListener('input', () => {
            this._scoreTargetValueEl.textContent = this._scoreTargetInput.value;
        });

        this._unlimitedTimeCheckbox.addEventListener('change', () => {
            this._timeLimitRow.style.display = this._unlimitedTimeCheckbox.checked ? 'none' : 'flex';
        });

        this._timeLimitInput.addEventListener('input', () => {
            this._timeLimitValueEl.textContent = this._timeLimitInput.value;
        });

        this._createGameButton.addEventListener('click', () => {
            // TODO cela n'est pas le lieu pour envoyer les messages
            this._eventSink.createGame(this._createGame,{
                name: this._gameNameInput.value.trim() || 'Untitled Game',
                password: this._gamePasswordInput.value || null,
                humanCount: parseInt(this._humanCountInput.value, 10),
                aiCount: parseInt(this._aiCountInput.value, 10),
                width: parseInt(this._mazeWidthInput.value, 10),
                length: parseInt(this._mazeLengthInput.value, 10),
                height: parseInt(this._mazeHeightInput.value, 10),
                sessionToken: this._sessionToken,
                playerName: this._playerProfile.name,
                primaryColor: this._playerProfile.primaryColor,
                secondaryColor: this._playerProfile.secondaryColor,
                sprite: this._playerProfile.sprite,
                scoreTarget: parseInt(this._scoreTargetInput.value, 10),
                timeLimitMs: this._unlimitedTimeCheckbox.checked ? null : parseInt(this._timeLimitInput.value, 10),
            });
        });

        this._cancelCreateGameButton.addEventListener('click', () => {
            this._eventSink.cancelGame();
        });

        this._updateMazeSizeSummary();
    }

    createGame() {
        return this._createGame();
    }

    currentTotalPlayers() {
        return parseInt(this._humanCountInput.value, 10) + parseInt(this._aiCountInput.value, 10);
    }
}
