codeunit 50281 "Ws Subscribers"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Dep Events", 'OnWorked', '', false, false)]
    local procedure OnWorkedHandler()
    var
        Hooks: Codeunit "Ws Hooks";
    begin
        Hooks.Handled();
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sym Api", 'OnComputed', '', false, false)]
    local procedure OnComputedHandler()
    var
        Hooks: Codeunit "Ws Hooks";
    begin
        Hooks.SymHandled();
    end;

    [EventSubscriber(ObjectType::Table, Database::"Dep Item", 'OnAfterInsertEvent', '', false, false)]
    local procedure OnAfterInsertDepItem(var Rec: Record "Dep Item"; RunTrigger: Boolean)
    var
        Hooks: Codeunit "Ws Hooks";
    begin
        Hooks.AfterInsert();
    end;
}
