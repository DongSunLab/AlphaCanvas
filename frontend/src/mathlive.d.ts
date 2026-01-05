declare module 'mathlive' {
  export class MathfieldElement extends HTMLElement {
    value: string;
    getValue(format?: string): any;
    setValue(value: string, options?: any): void;
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    'math-field': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}

