// Type declaration for neo-blessed
// neo-blessed is API-compatible with blessed, so we re-export blessed types
declare module 'neo-blessed' {
  import * as blessed from 'blessed';
  export = blessed;
}
