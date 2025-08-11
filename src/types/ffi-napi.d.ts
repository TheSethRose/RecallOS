// T-019: Minimal type shims for optional FFI modules (scaffolding only)

declare module 'ffi-napi' {
  const ffi: any;
  export = ffi;
}

declare module 'ref-napi' {
  const ref: any;
  export = ref;
}

declare module 'ref-struct-napi' {
  const Struct: any;
  export = Struct;
}