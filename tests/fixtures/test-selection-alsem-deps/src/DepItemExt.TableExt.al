tableextension 50282 "Dep Item Ext" extends "Dep Item"
{
    trigger OnAfterInsert()
    var
        Hooks: Codeunit "Ws Hooks";
    begin
        Hooks.ExtAfterInsert();
    end;
}
