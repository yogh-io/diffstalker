; Outline query for Java.
;
; Java's structure is explicit, so this is short and needs no containment
; guards: a method_declaration only ever appears in a class, interface,
; enum or record body.

(class_declaration
  name: (identifier) @name) @symbol.class

(interface_declaration
  name: (identifier) @name) @symbol.interface

(enum_declaration
  name: (identifier) @name) @symbol.enum

(record_declaration
  name: (identifier) @name) @symbol.class

(annotation_type_declaration
  name: (identifier) @name) @symbol.interface

(method_declaration
  name: (identifier) @name) @symbol.method

(constructor_declaration
  name: (identifier) @name) @symbol.constructor

(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @symbol.field
