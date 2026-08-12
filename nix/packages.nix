{
  callPackage,
}:
let
  mkSkill = callPackage ./mk-skill.nix { };
in
{
  hedgedoc = callPackage ../hedgedoc { };
  kleinanzeigen = callPackage ../kleinanzeigen { };
  todos = callPackage ../todos { inherit mkSkill; };
}
