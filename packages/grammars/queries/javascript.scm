; Outline query for JavaScript.
;
; Derived from typescript.scm minus everything TypeScript-only (no
; interfaces, no type aliases, no enums, no signatures). The shared
; patterns are deliberately identical so a symbol looks the same in a .js
; and a .ts file — an outline that ranks or names things differently by
; extension teaches the reader nothing.

(function_declaration
  name: (identifier) @name) @symbol.function

(generator_function_declaration
  name: (identifier) @name) @symbol.function

(class_declaration
  name: (identifier) @name) @symbol.class

(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @symbol.method

(field_definition
  property: [(property_identifier) (private_property_identifier)] @name) @symbol.field

; `const render = () => {…}` reads as a function; a const holding a plain
; value does not, or the outline becomes a list of every constant.

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @symbol.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @symbol.function
