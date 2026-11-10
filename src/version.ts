declare const __VERSION__: string | undefined;
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
