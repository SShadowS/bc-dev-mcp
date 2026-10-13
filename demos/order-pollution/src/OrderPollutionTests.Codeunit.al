codeunit 50161 "Order Pollution Tests"
{
    Subtype = Test;

    // Eight methods, two genuine polluter/victim pairs (see demos/ORDER-POLLUTION.md):
    //   PolluterCommitsCustomer (1) -> VictimInsertsSameCustomer (3)   via Customer
    //   PolluterCommitsFlag     (5) -> VictimExpectsNoFlag       (7)   via "Order Pollution Flag"
    // Pollution only exists INSIDE one RunTests group: BC rolls every group back on
    // completion (even explicit Commit()) and runs a group's methods in declaration order,
    // so a polluter must be declared above its victim and selected in the same group.

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure PolluterCommitsCustomer()
    var
        Customer: Record Customer;
    begin
        Customer.Init();
        Customer."No." := 'ODPOLL-C1';
        Customer.Name := 'Order pollution demo';
        Customer.Insert();
        Commit();
    end;

    [Test]
    procedure IndependentArithmetic()
    begin
        if 6 * 7 <> 42 then
            Error('Arithmetic is broken');
    end;

    [Test]
    procedure VictimInsertsSameCustomer()
    var
        Customer: Record Customer;
    begin
        // Passes in isolation; fails with "already exists" when PolluterCommitsCustomer ran earlier in the group.
        Customer.Init();
        Customer."No." := 'ODPOLL-C1';
        Customer.Insert();
    end;

    [Test]
    procedure IndependentCompanyName()
    begin
        if CompanyName() = '' then
            Error('No company context');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure PolluterCommitsFlag()
    var
        Flag: Record "Order Pollution Flag";
    begin
        Flag.Code := 'DEMO';
        Flag.Insert();
        Commit();
    end;

    [Test]
    procedure IndependentRolledBackWrite()
    var
        Customer: Record Customer;
    begin
        // Writes but does not pollute: AutoRollback (the default) undoes it when the method ends.
        Customer.Init();
        Customer."No." := 'ODPOLL-C6';
        Customer.Insert();
        if not Customer.Get('ODPOLL-C6') then
            Error('Customer ODPOLL-C6 was not inserted');
    end;

    [Test]
    procedure VictimExpectsNoFlag()
    var
        Flag: Record "Order Pollution Flag";
    begin
        // Passes in isolation; fails when PolluterCommitsFlag ran earlier in the group.
        if not Flag.IsEmpty() then
            Error('Expected no Order Pollution Flag rows, found %1', Flag.Count());
    end;

    [Test]
    procedure IndependentLast()
    begin
        if StrLen('done') <> 4 then
            Error('StrLen is broken');
    end;
}
