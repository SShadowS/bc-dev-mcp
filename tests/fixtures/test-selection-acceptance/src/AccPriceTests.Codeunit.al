codeunit 50942 "Acc Price Tests"
{
    Subtype = Test;

    [Test]
    procedure LineAmountMultiplies()
    var
        Core: Codeunit "Acc Price Core";
    begin
        if Core.LineAmount(3, 2.5) <> 7.5 then
            Error('LineAmount(3, 2.5) should be 7.5');
    end;

    [Test]
    procedure NoBreakBelowTen()
    var
        Rules: Codeunit "Acc Price Rules";
    begin
        if Rules.NetLineAmount(5, 10) <> 50 then
            Error('NetLineAmount(5, 10) should be 50');
    end;

    [Test]
    procedure FivePercentBreak()
    var
        Rules: Codeunit "Acc Price Rules";
    begin
        if Rules.NetLineAmount(10, 10) <> 95 then
            Error('NetLineAmount(10, 10) should be 95');
    end;

    [Test]
    procedure TenPercentBreak()
    var
        Rules: Codeunit "Acc Price Rules";
    begin
        if Rules.NetLineAmount(100, 1) <> 90 then
            Error('NetLineAmount(100, 1) should be 90');
    end;

    [Test]
    procedure ZeroQuantityFails()
    var
        Rules: Codeunit "Acc Price Rules";
    begin
        asserterror Rules.NetLineAmount(0, 1);
    end;
}
