export interface PageLink {
  readonly label: string
  readonly url: string
}

export interface PageInput {
  readonly ref: string
  readonly type: string
  readonly placeholder: string
}

export interface PageInfo {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly links: readonly PageLink[]
  readonly inputs: readonly PageInput[]
}

export interface BrowserBackend {
  navigate(url: string): Promise<PageInfo>
  click(ref: string): Promise<PageInfo>
  type(ref: string, text: string): Promise<PageInfo>
  screenshot(): Promise<Buffer>
  getText(): Promise<string>
  back(): Promise<PageInfo>
  cleanup(): Promise<void>
}
