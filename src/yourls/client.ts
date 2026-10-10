export interface YourlsConfig {
  apiUrl?: string;
  signature?: string;
  shortDomain?: string;
}

export interface ShortenResult {
  keyword: string;
  shorturl: string;
  longurl: string;
  title?: string;
}

export class YourlsClient {
  constructor(private readonly config: YourlsConfig) {}

  configured(): boolean {
    return Boolean(this.config.apiUrl && this.config.signature);
  }

  async shorten(url: string, keyword?: string, title?: string): Promise<ShortenResult> {
    if (!this.configured()) {
      const fallbackKeyword = keyword || `dev-${Math.random().toString(36).slice(2, 8)}`;
      return { keyword: fallbackKeyword, shorturl: `${this.config.shortDomain || 'http://localhost:3000/r'}/${fallbackKeyword}`, longurl: url, title };
    }
    const result = await this.request({ action: 'shorturl', url, keyword, title });
    return {
      keyword: result.url?.keyword || result.keyword || keyword || '',
      shorturl: result.shorturl || result.url?.shorturl,
      longurl: result.url?.url || result.longurl || url,
      title
    };
  }

  async expand(shorturl: string): Promise<string> {
    const result = await this.request({ action: 'expand', shorturl });
    return result.longurl || result.url || '';
  }

  async urlStats(shorturl: string): Promise<Record<string, unknown>> {
    return this.request({ action: 'url-stats', shorturl });
  }

  async stats(filter = 'last', limit = 20): Promise<Record<string, unknown>> {
    return this.request({ action: 'stats', filter, limit: String(limit) });
  }

  private async request(params: Record<string, string | undefined>): Promise<any> {
    if (!this.config.apiUrl || !this.config.signature) throw new Error('YOURLS API is not configured');
    const body = new URLSearchParams();
    body.set('format', 'json');
    body.set('signature', this.config.signature);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') body.set(key, value);
    }
    const response = await fetch(this.config.apiUrl, { method: 'POST', body });
    const text = await response.text();
    const json = JSON.parse(text);
    if (!response.ok || (json.statusCode && Number(json.statusCode) >= 400)) {
      throw new Error(json.message || `YOURLS API failed with ${response.status}`);
    }
    return json;
  }
}
