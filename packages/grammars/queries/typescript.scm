; Outline query for TypeScript and TSX.
;
; Ours, not upstream's `tags.scm`: that one is built for code navigation
; and captures references as well as definitions, which is the wrong shape
; for "what is in this file". Every pattern here binds exactly one
; @symbol.<kind> and one @name, and the extractor reads nothing else.
;
; Tuned against this repo's own sources. Adding a pattern means re-running
; the golden fixtures — a query that captures the wrong node produces a
; confidently wrong label, which is the failure this whole feature is
; organised against.

; --- Declarations -----------------------------------------------------

(function_declaration
  name: (identifier) @name) @symbol.function

(generator_function_declaration
  name: (identifier) @name) @symbol.function

(class_declaration
  name: (type_identifier) @name) @symbol.class

(interface_declaration
  name: (type_identifier) @name) @symbol.interface

(type_alias_declaration
  name: (type_identifier) @name) @symbol.type

(enum_declaration
  name: (identifier) @name) @symbol.enum

(module
  name: [(identifier) (string)] @name) @symbol.namespace

; --- Class members ----------------------------------------------------

(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @symbol.method

(public_field_definition
  name: [(property_identifier) (private_property_identifier)] @name) @symbol.field

; Interface members only. An unrestricted property_signature also matches
; members of an anonymous type literal — a return type like
; `{ row: number; column: number }` would list `row` and `column` as
; symbols of the file, which is noise dressed as structure.

; Abstract members live in a class body, never an interface body — so this
; one needs no containment guard.
(abstract_method_signature
  name: (property_identifier) @name) @symbol.method

(interface_body
  (method_signature
    name: (property_identifier) @name) @symbol.method)

(interface_body
  (property_signature
    name: (property_identifier) @name) @symbol.field)

; --- Top-level bindings that hold a function --------------------------
;
; `const render = () => {…}` is a function to a reader, so it reads as one
; here. A const holding a plain value is NOT captured: an outline listing
; every constant stops being an outline.

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @symbol.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @symbol.function
