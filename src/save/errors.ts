export type SaveErrorCode = 'input'|'config'|'limit'|'memory'|'format'|'download'|'encode'|'validation'|'timeout'|'busy'|'shutdown'|'upload';

const messages: Record<SaveErrorCode, string> = {
  input: 'Podaj link HTTP lub HTTPS do jednego filmu z ustaloną długością. Playlisty i transmisje na żywo nie są obsługiwane.',
  config: 'Konfiguracja /save jest nieprawidłowa. Sprawdź sekcję save w config.json.',
  limit: 'Przekroczono limit pobierania do RAM. Spróbuj z mniejszym filmem.',
  memory: 'Brakuje dostępnej pamięci RAM lub miejsca w tmpfs albo nie mogę bezpiecznie ustalić ich limitów.',
  format: 'Nie znalazłem formatu filmu mieszczącego się w budżecie RAM i obsługiwanej jakości.',
  download: 'Nie udało się pobrać filmu. Link może być niedostępny, chroniony albo wymagać logowania.',
  encode: 'Nie udało się przekonwertować filmu do MP4.',
  validation: 'Nie udało się przygotować kompletnego filmu poniżej limitu załącznika.',
  timeout: 'Przekroczono czas operacji. Spróbuj z krótszym filmem.',
  busy: 'Przetwarzam już inny film przez /save. Spróbuj ponownie po jego zakończeniu.',
  shutdown: 'Przerwano operację, ponieważ bot jest wyłączany.',
  upload: 'Film jest gotowy, ale nie udało się wysłać załącznika do Discorda.',
};

export class SaveError extends Error {
  constructor(public readonly code: SaveErrorCode, detail?: string,
              public readonly size?: number, public readonly limit?: number) {
    super(detail ?? messages[code]);
    this.name = 'SaveError';
  }

  get userMessage(): string {
    return messages[this.code] + (this.size !== undefined && this.limit !== undefined ?
        ` Rozmiar: ${this.size} bajtów; limit: ${this.code === 'limit' ? '≤' : '<'}${this.limit} bajtów.` : '');
  }
}
