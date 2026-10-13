codeunit 50290 "Ws Tests"
{
    Subtype = Test;

    [Test]
    procedure WorkRaises()
    var
        W: Codeunit "Dep Worker";
    begin
        W.Work();
    end;

    [Test]
    procedure InsertItem()
    var
        Item: Record "Dep Item";
    begin
        Item.Insert(true);
    end;

    [Test]
    procedure ComputeSym()
    var
        S: Codeunit "Sym Api";
    begin
        S.Compute();
    end;
}
