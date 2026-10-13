table 50190 "RW Live Target"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; Id; Integer) { }
        field(2; Note; Text[50]) { }
    }

    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}
