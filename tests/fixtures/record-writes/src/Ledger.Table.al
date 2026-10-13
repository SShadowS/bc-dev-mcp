table 50170 "RW Ledger"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Amount; Decimal) { }
    }

    keys
    {
        key(PK; Code) { Clustered = true; }
    }
}
